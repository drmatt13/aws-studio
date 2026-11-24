import { randomUUID } from "node:crypto";
import {
  assertPayloadWithinLimit,
  getAgentTools,
  getGatewayTools,
  WorkflowStateError,
  WORKFLOW_ERROR_NAMES,
  type FrameworkConfig,
  type LambdaTarget,
} from "../config/index";
import { MCP_PROTOCOL_VERSION, SERVICE_SESSION_OWNER, SESSION_HEADER } from "../protocol/agentcore";
import { gatewayInputSchema, type GatewayToolManifest } from "../protocol/tool-schema";
import { agentSessionId, type AgentToolSpec, type GatewayDescriptor } from "../runtime/agentcore";
import type { LocalInvocationContext } from "./index";
import { observeDevelopment, newDevelopmentCorrelation, developmentCorrelation, encodeDevelopmentCorrelation, withDevelopmentObservation } from "../development-logs/index";

export type { GatewayToolEntry, GatewayToolManifest } from "../protocol/tool-schema";

/**
 * AgentCore Gateway, emulated for local development.
 *
 * The local API dev server builds the event API Gateway builds; this answers
 * the MCP calls a declared Gateway answers, in the same spirit. Every Gateway
 * exposes its declared tools to the agents selecting it, as the deployed one
 * does, and a call reaches the tool the way a Gateway Lambda
 * target is invoked: the argument map as the event, and Gateway's metadata as
 * `context.clientContext.custom`. The tool runs through the same local Lambda
 * executor every other handler uses, against local Postgres and the developer's
 * AWS profile.
 *
 * Tool schemas come from the generated contract projection, so editing a
 * description or a field takes effect on the next call — there is nothing to
 * deploy. What the emulator cannot prove — Gateway's IAM, its schema
 * enforcement, its error text — is checked against a deployed Gateway by
 * `npm run agents:smoke`.
 */

/** The part of the local Lambda executor the emulator uses. */
export interface LocalToolInvoker {
  invoke(target: LambdaTarget, event: unknown, context?: LocalInvocationContext): Promise<unknown>;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: string | number | null;
  readonly method?: unknown;
  readonly params?: { readonly name?: unknown; readonly arguments?: unknown };
}

/** Where a declared Gateway answers, with its consuming agent attached for the local binding check. */
export function localGatewayDescriptor(gatewayId: string, runnerUrl: string, agentId?: string): GatewayDescriptor {
  return { transport: "local", url: `${runnerUrl.replace(/\/+$/, "")}/gateways/${gatewayId}/mcp`, ...(agentId ? { caller: `agent:${agentId}` } : {}) };
}

/** The tools an agent's adapter is told about, from the generated projection. */
export function agentToolSpecs(
  config: FrameworkConfig,
  agentId: string,
  manifest: GatewayToolManifest,
): readonly AgentToolSpec[] {
  return getAgentTools(config, agentId).map((tool) => {
    const entry = manifest[tool.id];
    if (!entry) {
      throw new Error(`tools["${tool.id}"] has no generated contract. Run npm run framework:generate.`);
    }
    return { ...tool, description: entry.description, inputSchema: entry.inputSchema };
  });
}

/**
 * Answers one JSON-RPC message sent to `gatewayId`. A notification has
 * no reply, which the runner answers with HTTP 202 as Streamable HTTP does.
 */
export async function handleLocalGatewayRequest(
  config: FrameworkConfig,
  invoker: LocalToolInvoker,
  gatewayId: string,
  body: unknown,
  manifest: GatewayToolManifest,
): Promise<unknown | undefined> {
  const request = (body ?? {}) as JsonRpcRequest;
  if (request.id === undefined) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
  const failure = (code: number, message: string) => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  if (request.jsonrpc !== "2.0") return failure(-32600, "Expected a JSON-RPC 2.0 request.");

  const tools = getGatewayTools(config, gatewayId);
  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: `local-gateway-${gatewayId}`, version: "1" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map((tool) => {
          const entry = manifest[tool.id];
          return {
            name: tool.wireName,
            description: entry.description,
            inputSchema: gatewayInputSchema(entry),
            outputSchema: entry.outputSchema,
          };
        }),
      });
    case "tools/call": {
      const tool = tools.find((candidate) => candidate.wireName === request.params?.name);
      if (!tool) {
        observeDevelopment({ resourceId: `gateway:agentcore:${gatewayId}`, kind: "agent.gateway_tool_rejected", level: "warn", details: { reason: "unknown-tool", name: request.params?.name } });
        return failure(-32602, `Unknown tool: ${String(request.params?.name)}`);
      }
      const args = request.params?.arguments ?? {};
      const correlation = newDevelopmentCorrelation({ toolCallId: developmentCorrelation()?.toolCallId ?? String(request.id) });
      return withDevelopmentObservation({ resourceId: `gateway:agentcore:${gatewayId}`, correlation }, async () => {
      observeDevelopment({ resourceId: `gateway:agentcore:${gatewayId}`, kind: "agent.gateway_tool_dispatched", relatedResourceIds: [`lambda:${tool.id}`], details: { toolId: tool.id, input: args } });
      try {
        const result = await invoker.invoke(`lambda:${tool.id}`, args, {
          awsRequestId: randomUUID(),
          clientContext: {
            custom: {
              bedrockAgentCoreMessageVersion: "1.0",
              bedrockAgentCoreAwsRequestId: randomUUID(),
              bedrockAgentCoreMcpMessageId: String(request.id),
              bedrockAgentCoreGatewayId: `local-${gatewayId}`,
              bedrockAgentCoreTargetId: `local-${tool.id}`,
              bedrockAgentCoreToolName: tool.wireName,
            },
          },
        });
        observeDevelopment({ resourceId: `gateway:agentcore:${gatewayId}`, kind: "agent.gateway_tool_completed", relatedResourceIds: [`lambda:${tool.id}`], details: { toolId: tool.id, result } });
        return reply({ isError: false, structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) {
        // The tool's wrapper already reduced its own failures to a sentence the
        // model may read; anything else is the executor's — a timeout, a crash.
        const message = error instanceof Error ? error.message : String(error);
        observeDevelopment({ resourceId: `gateway:agentcore:${gatewayId}`, kind: "agent.gateway_tool_failed", level: "error", relatedResourceIds: [`lambda:${tool.id}`], details: { error } });
        return reply({ isError: true, content: [{ type: "text", text: message }] });
      }
      });
    }
    default:
      return failure(-32601, `Method not found: ${String(request.method)}`);
  }
}

// ---------------------------------------------------------------------------
// A workflow step's call
// ---------------------------------------------------------------------------

/** The part of the runner's agent supervisor a workflow step uses. */
export interface LocalAgentInvoker {
  invoke(
    id: string,
    request: { readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly signal?: AbortSignal },
    consume: (response: Response) => Promise<void>,
  ): Promise<void>;
}

/**
 * `invokeAgent` as a workflow step, in the local lane.
 *
 * The request Step Functions sends in AWS: the adapter's body, and the session
 * the adapter derives for a caller with no user, so the agent cannot tell the
 * lanes apart. An error status becomes the error Step Functions raises for it.
 */
export async function invokeAgentStep(
  agents: LocalAgentInvoker,
  id: string,
  request: { readonly conversationId: string; readonly input: unknown },
  signal: AbortSignal,
): Promise<unknown> {
  let status = 0;
  let contentType = "";
  let text = "";
  await agents.invoke(
    id,
    {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [SESSION_HEADER]: agentSessionId(SERVICE_SESSION_OWNER, request.conversationId),
        ...(process.env.FRAMEWORK_DEVELOPMENT_LOGS === "1" && developmentCorrelation() ? { "x-framework-development-observation": encodeDevelopmentCorrelation() } : {}),
      },
      body: JSON.stringify({ conversationId: request.conversationId, input: request.input }),
      signal,
    },
    async (response) => {
      status = response.status;
      contentType = response.headers.get("content-type") ?? "";
      text = await response.text();
    },
  );
  if (status < 200 || status >= 300) {
    // AWS returns the status and not the body — "Received error (500) from
    // runtime" — so a graph cannot come to depend on detail it will not get
    // there. The body is printed here, where only the developer reads it.
    console.error(`[agent:${id}] answered HTTP ${status}: ${text.slice(0, 2000)}`);
    throw new WorkflowStateError(
      WORKFLOW_ERROR_NAMES.agentFailed,
      `Received error (${status}) from runtime. The agent's own log has the detail.`,
    );
  }
  // The task result AWS measures is the whole SDK answer, with the body as an
  // escaped string — larger than the parsed result — so that is what is
  // measured here too.
  assertPayloadWithinLimit({ Response: text, ContentType: contentType, StatusCode: status }, `agent:${id}'s answer`);
  // `$parse($states.result.Response).result`: a body that is not JSON, or has
  // no `result`, fails the compiled expression rather than the call.
  let result: unknown;
  try {
    result = (JSON.parse(text) as { readonly result?: unknown } | null)?.result;
  } catch {
    result = undefined;
  }
  if (result === undefined) {
    throw new WorkflowStateError(
      WORKFLOW_ERROR_NAMES.queryEvaluation,
      contentType.includes("text/event-stream")
        ? `agent:${id} streams events, and a workflow step needs one response. Give the agent a response contract.`
        : `agent:${id} answered with no JSON \`result\`.`,
    );
  }
  return result;
}

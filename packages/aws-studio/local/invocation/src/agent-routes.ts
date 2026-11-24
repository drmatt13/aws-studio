import { Readable } from "node:stream";
import type express from "express";
import { getLocalGateways, getLocalTargets, type DeployLane, type FrameworkConfig } from "aws-studio/config";
import {
  assertLocalInvocationEdge,
  handleLocalGatewayRequest,
  type GatewayToolManifest,
  type LocalToolInvoker,
} from "aws-studio/local";
import type { AgentForward } from "./agents";
import { observeDevelopment } from "aws-studio/development-logs";

/**
 * The runner's AgentCore surface: agent invocations and declared Gateways.
 *
 * `POST /agents/<id>/invocations` is the local Runtime endpoint. A backend
 * caller names itself in x-framework-caller and must have declared
 * `invokesAgent(<id>)` — the local half of the IAM grant. A request without a
 * caller has come from the browser through the local API dev server, which
 * verified the user, and only an agent with users is reachable that way; the
 * agent's adapter verifies the token again.
 *
 * `POST /gateways/<id>/mcp` checks that x-framework-caller is a local agent
 * selecting this Gateway, then serves the Gateway's declared tools.
 */

/** The part of LocalAgentSupervisor these routes use. */
export interface AgentInvoker {
  invoke(id: string, request: AgentForward, consume: (response: Response) => Promise<void>): Promise<void>;
}

export interface AgentRouteOptions {
  readonly config: FrameworkConfig;
  readonly agents: AgentInvoker;
  /** Runs tool Lambdas. A fresh process per call, so an edited tool runs as edited. */
  readonly tools: LocalToolInvoker;
  readonly loadTools: () => Promise<GatewayToolManifest>;
  readonly inputs?: DeployLane;
}

const FORWARDED_HEADERS = ["content-type", "authorization", "x-amzn-bedrock-agentcore-runtime-session-id"];
const RETURNED_HEADERS = ["content-type", "cache-control"];

export function registerAgentRoutes(app: express.Express, options: AgentRouteOptions): void {
  app.post("/agents/:id/invocations", async (request, response) => {
    const id = String(request.params.id);
    const declaration = options.config.agents?.[id];
    const caller = request.header("x-framework-caller");
    try {
      if (caller) {
        assertLocalInvocationEdge(options.config, caller, `agent:${id}`);
      } else if (declaration?.auth !== true) {
        if (declaration) observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.caller_rejected", level: "warn", details: { reason: "browser-route-not-authorized" } });
        response.status(403).json({
          error: `agent:${id} has no auth: true, so it is reachable only from a workload that declares invokesAgent("${id}").`,
        });
        return;
      }
    } catch (error) {
      if (declaration) observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.caller_rejected", level: "warn", details: { error } });
      response.status(403).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.header(name);
      if (value !== undefined) headers[name] = value;
    }

    try {
      observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.proxy_dispatched", details: { caller: caller ?? "browser" } });
      await options.agents.invoke(
        id,
        { headers, body: JSON.stringify(request.body), signal: controller.signal },
        async (reply) => {
          response.status(reply.status);
          for (const name of RETURNED_HEADERS) {
            const value = reply.headers.get(name);
            if (value !== null) response.setHeader(name, value);
          }
          if (!reply.body) {
            response.end();
            return;
          }
          // Streamed through as it arrives, so server-sent events reach the
          // browser as the agent yields them.
          const body = Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]);
          body.pipe(response);
          await new Promise<void>((resolve) => {
            body.once("end", () => { observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.proxy_completed", details: { status: reply.status, evidence: "transport completion; adapter events determine execution outcome" } }); resolve(); });
            body.once("error", error => { observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.proxy_failed", level: "error", details: { error } }); resolve(); });
            response.once("close", () => { if (!response.writableFinished) observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.proxy_cancelled", level: "warn" }); resolve(); });
          });
        },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(`[agent:${id}] Invocation failed:`, error);
      if (!response.headersSent) response.status(502).json({ error: "LOCAL_AGENT_UNAVAILABLE" });
      else response.end();
    }
  });

  app.post("/gateways/:id/mcp", async (request, response) => {
    const id = String(request.params.id);
    if (!getLocalGateways(options.config, options.inputs).some(gateway => gateway.id === id)) {
      response.status(404).json({ error: `gateway:${id} is not enabled locally.` });
      return;
    }
    const caller = request.header("x-framework-caller");
    const agentId = caller?.startsWith("agent:") ? caller.slice("agent:".length) : undefined;
    if (!agentId || !options.config.agents?.[agentId]?.gateways?.includes(id) || !getLocalTargets(options.config, ["agent"], options.inputs).some(agent => agent.id === agentId)) {
      response.status(403).json({ error: `Caller "${caller ?? ""}" does not select gateway "${id}" for local execution.` });
      return;
    }
    try {
      observeDevelopment({ resourceId: `gateway:agentcore:${id}`, kind: "agent.gateway_received", relatedResourceIds: [caller!], details: { method: request.body?.method } });
      const reply = await handleLocalGatewayRequest(options.config, options.tools, id, request.body, await options.loadTools());
      if (reply === undefined) response.status(202).end();
      else response.json(reply);
    } catch (error) {
      console.error(`[agent:${id}] Gateway request failed:`, error);
      response.status(500).json({ error: "LOCAL_GATEWAY_FAILED" });
    }
  });
}

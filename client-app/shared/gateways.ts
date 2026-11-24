import type { Lanes, ModelRoute, ModelTarget, ModeModel } from "./model";

export interface ModelApiGateway {
  readonly id: "gateway:http" | "gateway:websocket";
  readonly title: string;
  readonly protocol: "http" | "websocket";
  readonly lanes: Lanes;
  readonly routes: readonly string[];
  readonly authorizer?: string;
  readonly stackResource: string;
}

export interface ModelAgentCoreGateway {
  readonly id: `gateway:agentcore:${string}`;
  readonly title: string;
  readonly protocol: "agentcore";
  readonly key: string;
  readonly origin: string;
  readonly lanes: Lanes;
  readonly tools: readonly string[];
  readonly consumers: readonly string[];
  readonly constructId: string;
  readonly constructIdPinned: boolean;
}
export type ModelGateway = ModelApiGateway | ModelAgentCoreGateway;

/** Real API Gateway resources; agent browser routes terminate at AgentCore. */
export function gatewayModels(routes: readonly ModelRoute[], targets: readonly ModelTarget[]): readonly ModelGateway[] {
  return (["http", "websocket"] as const).flatMap(protocol => {
    const selected = routes.filter(route => protocol === "http" ? route.kind === "http" || route.kind === "service" : route.kind === "webSocket");
    if (protocol === "websocket" && !selected.length) return [];
    const handlers = selected.flatMap(route => targets.filter(target => target.ref === route.target));
    const local = handlers.some(target => target.lanes.local);
    const dev = protocol === "websocket" && handlers.some(target => target.lanes.dev);
    const prod = protocol === "http" || handlers.some(target => target.lanes.prod);
    return [{ id: `gateway:${protocol}` as const, title: protocol === "http" ? "HTTP API" : "WebSocket API", protocol,
      lanes: { deploy: "both" as const, origin: "derived" as const, local, cloud: prod || dev, dev, prod },
      routes: selected.map(route => route.id), authorizer: selected.find(route => route.path === "$connect")?.authorizer,
      stackResource: `framework-stack:${protocol === "http" ? "HttpApiGatewayStack" : "WebSocketApiStack"}` }];
  });
}
export const gatewaysOf = (model: ModeModel): readonly ModelGateway[] => model.gateways ?? (model.status === "error" && !model.stale ? [] : gatewayModels(model.routes, model.targets));

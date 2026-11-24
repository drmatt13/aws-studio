import type { DraftEdit } from "../shared/api";
import { grantOptions, nativeGrantApplicationActions } from "../shared/grants";
import { normalizeResourceAccess, resourceAccessDefinition, resourceAccessKey } from "aws-studio/config/resource-access";
import type { ModeModel, ModelEdge, ModelTarget, SourceIndex } from "../shared/model";
import type { ConnectionAuthorization } from "../shared/permissions";
import { ICONS, resourceIcon, targetIcon, type IconKey } from "./icons";
import { indexModel, titleOf, ROLE_LABEL, type ModelIndex } from "./lookup";

export type ConnectionEdit = Extract<DraftEdit, { kind: "connection" }>;

/** Only known service helpers can be converted to the corresponding application actions. */
export function nativeAccessReplacement(edit: ConnectionEdit | undefined, source: SourceIndex): ConnectionEdit | undefined {
  if (edit?.connection !== "grant" || !edit.destination || !edit.grant) return;
  const types = source.permissionCapabilities?.find(item => item.resource === edit.destination)?.canonicalTypes ?? source.triggerCapabilities?.find(item => item.resource === edit.destination)?.canonicalTypes ?? [];
  const definition = resourceAccessDefinition(types), option = grantOptions(types).find(item => item.method === edit.grant);
  const actions = nativeGrantApplicationActions[edit.grant];
  if (!definition || !option || !actions || actions.some(action => !definition.actions.some(item => item.id === action))) return;
  const args = edit.grantArguments ?? (edit.scope ? [edit.scope] : []);
  if (args.length > (option.scope ? 1 : 0)) return;
  const scope = args[0];
  if (scope !== undefined && (typeof scope !== "string" || !scope || scope !== "*" && (!scope.endsWith("*") || /[?*]/.test(scope.slice(0, -1)) || scope.includes("${")))) return;
  return { kind: "connection", target: edit.target, connection: "resourceAccess", destination: edit.destination, enabled: true, actions, ...(typeof scope === "string" && scope !== "*" ? { limits: { objectPrefix: scope.slice(0, -1) } } : {}) };
}

export interface AccessDestination {
  /** Absent for policies/principals that do not have a graph entity. */
  readonly id?: string;
  readonly title: string;
  readonly icon: IconKey;
  readonly subtitle?: string;
}

export interface AccessEntry {
  /** Stable across source modes; authorization state is deliberately excluded. */
  readonly id: string;
  readonly connection?: string;
  readonly edge?: ModelEdge;
  /** Contains only the grants belonging to this side of the relationship. */
  readonly authorization: ConnectionAuthorization;
  readonly destination: AccessDestination;
  readonly operation: string;
  /** A bounded source edit, still subject to the normal reviewed writer checks. */
  readonly remove?: ConnectionEdit;
}

export function accessDestination(id: string, model: ModeModel, index: ModelIndex = indexModel(model)): AccessDestination {
  const target = index.targets.get(id);
  if (target) return { id, title: titleOf(index, id), icon: targetIcon(target), subtitle: ROLE_LABEL[target.role] };
  const gateway = index.gateways.get(id);
  if (gateway) return { id, title: titleOf(index, id), icon: "gateway", subtitle: gateway.protocol === "agentcore" ? "AgentCore Gateway" : "API Gateway" };
  const route = index.routes.get(id);
  if (route && route.kind !== "agent") {
    return { id: route.kind === "webSocket" ? "gateway:websocket" : "gateway:http", title: route.kind === "webSocket" ? "WebSocket API" : "HTTP API", icon: "gateway", subtitle: route.browserPath ?? route.path };
  }
  const local = index.localServices.get(id);
  if (local) return { id, title: titleOf(index, id), icon: "postgres", subtitle: "Local database" };
  const resource = index.resources.get(id);
  if (resource) {
    const icon = resource.frameworkManaged === "database" ? "database" : resourceIcon(resource);
    return { id, title: titleOf(index, id), icon, subtitle: ICONS[icon][1] };
  }
  // Some source-only permission scopes do not produce graph resources.
  return { title: id, icon: "construct" };
}

function declaredTrue(target: ModelTarget, edge: ModelEdge, field: "database" | "userPool", model: ModeModel, source: SourceIndex): boolean {
  const entity = source.entities[target.ref];
  if (!entity) return false;
  const fact = model.fields[target.ref]?.find(item => item.path.length === 1 && item.path[0] === field);
  const editability = fact && source.editability[target.ref]?.[fact.field];
  if (fact?.authored === true && editability?.kind === "literal" && editability.text.trim() === "true") return true;
  const setting = edge.bindingSetting;
  return setting?.field === field && setting.value === true && setting.source.file === entity.value.file &&
    setting.source.start >= entity.value.start && setting.source.end <= entity.value.end;
}

/** Never derive a removal from a display label, IAM action list, or arrow direction alone. */
export function removalForConnection(target: ModelTarget, edge: ModelEdge, model: ModeModel, source?: SourceIndex): ConnectionEdit | undefined {
  if (target.kind === "workflow" || edge.from !== target.ref || edge.provenance === "source" || !source?.entities[target.ref]) return;
  const base = { kind: "connection", target: target.ref, enabled: false } as const;
  const destination = model.targets.find(item => item.ref === edge.to);
  if (edge.provenance === "declared") {
    if (edge.relation === "grant" && edge.permissionContext?.kind === "managedPolicy") return { ...base, connection: "managedPolicy", destination: edge.to };
    if (edge.relation === "grant" && edge.permissionContext?.kind === "resourceAccess") {
      const context = edge.permissionContext;
      const capability = source.permissionCapabilities?.find(item => item.resource === edge.to);
      const definition = capability && resourceAccessDefinition(capability.canonicalTypes);
      if (!definition) return;
      try {
        const options = normalizeResourceAccess({ actions: context.actions, limits: context.limits }, definition);
        const duplicates = model.edges.filter(item => item.from === target.ref && item.to === edge.to && item.permissionContext?.kind === "resourceAccess" && resourceAccessKey({ actions: item.permissionContext.actions, limits: item.permissionContext.limits }) === resourceAccessKey(options));
        if (duplicates.length !== 1) return;
        return { ...base, connection: "resourceAccess", destination: edge.to, ...options };
      } catch { return; }
    }
    if (edge.relation === "runsTask" && destination?.kind === "task" ||
        edge.relation === "startsWorkflow" && destination?.kind === "workflow" ||
        edge.relation === "invokesAgent" && destination?.kind === "agent") {
      return { ...base, connection: edge.relation as "runsTask" | "startsWorkflow" | "invokesAgent", destination: edge.to };
    }
    if (edge.relation === "grant" && edge.permissionContext?.kind === "native") {
      const context = edge.permissionContext;
      const capability = source.permissionCapabilities?.find(item => item.resource === edge.to);
      const types = capability?.canonicalTypes ?? source.triggerCapabilities?.find(item => item.resource === edge.to)?.canonicalTypes ?? [];
      const option = grantOptions(types).find(item => item.method === context.method);
      const discovered = capability?.grants?.find(item => item.method === context.method && !item.reason);
      if ((!option && !discovered) || !model.resources.some(item => item.id === edge.to)) return;
      const args = context.arguments;
      // The writer distinguishes no argument from a nonempty literal scope. An
      // explicit empty string, multiple arguments or computed values are source-owned.
      if (!discovered && (args.length > 1 || args.length === 1 && (!option?.scope || typeof args[0] !== "string" || !args[0] || args[0].length > 256 || /[\r\n\0]/.test(args[0])))) return;
      const duplicates = model.edges.filter(item => item.from === target.ref && item.to === edge.to && item.relation === "grant" &&
        item.permissionContext?.kind === "native" && item.permissionContext.method === context.method &&
        JSON.stringify(item.permissionContext.arguments) === JSON.stringify(args));
      if (duplicates.length > 1) return;
      return { ...base, connection: "grant", destination: edge.to, grant: context.method, ...(discovered ? { grantArguments: args as import("aws-studio/config/cdk-resources").JsonArgument[] } : { scope: args.length ? args[0] as string : "" }) };
    }
    if (edge.relation === "env" || edge.relation === "secret") {
      const resource = model.resources.find(item => item.id === edge.to);
      const secret = resource?.kind === "secret" || resource?.nativeKind === "secret";
      if (!resource || !["input", "secret"].includes(resource.kind) && !secret || !/^[A-Z][A-Z0-9_]*$/.test(edge.label)) return;
      const environment = target.environment.find(item => item.name === edge.label);
      const startup = target.secrets.find(item => item.name === edge.label);
      const container = target.kind === "service" || target.kind === "task";
      const matches = edge.relation === "secret"
        ? container && secret && startup?.resource === edge.to
        : !(container && secret) && !environment?.via && environment?.value.kind === "reference" && environment.value.resource === edge.to;
      if (matches) return { ...base, connection: "resource", destination: edge.to, variable: edge.label };
    }
  }
  if (edge.relation === "database" && target.kind !== "agent" && edge.permissionContext?.kind === "database" &&
      edge.permissionContext.connection === "application" && declaredTrue(target, edge, "database", model, source)) return { ...base, connection: "database" };
  if (edge.relation === "env" && !["agent", "tool"].includes(target.role) && target.userPool &&
      target.environment.some(item => item.name === edge.label && item.via === "userPool" && item.value.kind === "reference" && item.value.resource === edge.to) &&
      declaredTrue(target, edge, "userPool", model, source)) return { ...base, connection: "userPool" };
  return;
}

export function accessOperation(authorization: ConnectionAuthorization, edge?: ModelEdge, source?: SourceIndex): string {
  if (edge?.permissionContext?.kind === "resourceAccess") {
    const context = edge.permissionContext;
    const definition = resourceAccessDefinition(source?.permissionCapabilities?.find(item => item.resource === edge.to)?.canonicalTypes ?? []);
    return context.actions.map(action => definition?.actions.find(item => item.id === action)?.label ?? action).join(", ");
  }
  if (authorization.grants.some(grant => grant.actions?.includes("states:SendTaskSuccess")) &&
      authorization.grants.every(grant => grant.actions?.every(action => action.startsWith("states:SendTask")))) return "Complete workflow callback";
  if (edge?.permissionContext?.kind === "native") {
    const method = edge.permissionContext.method;
    const types = source?.permissionCapabilities?.find(item => item.resource === edge.to)?.canonicalTypes ?? source?.triggerCapabilities?.find(item => item.resource === edge.to)?.canonicalTypes ?? [];
    return grantOptions(types).find(item => item.method === method)?.label ?? authorization.operation;
  }
  switch (edge?.relation) {
    case "routes": case "authorizes": return "Invoke function";
    case "runsTask": return "Run task";
    case "startsWorkflow": return "Start workflow";
    case "invokesAgent": return "Invoke agent";
    case "usesTool": return "Invoke tool";
    case "usesGateway": return "Invoke gateway";
    case "database": return edge.permissionContext?.kind === "database" && edge.permissionContext.connection === "direct" ? "Connect directly to PostgreSQL" : "Connect to PostgreSQL";
    case "localReplay": return "Capture local replay";
    case "manageConnections": return "Send WebSocket replies";
    default: return authorization.operation;
  }
}

/** Ownership follows the receiving IAM principal, including pull triggers and
 * callback grants that run opposite the graph arrow. */
export function targetAccess(target: ModelTarget, model: ModeModel, source?: SourceIndex): { owned: AccessEntry[]; incoming: AccessEntry[] } {
  const index = indexModel(model), edges = new Map(model.edges.map(edge => [edge.id, edge]));
  const result: { owned: AccessEntry[]; incoming: AccessEntry[] } = { owned: [], incoming: [] };
  for (const item of target.authorizations ?? []) {
    const edge = item.connection ? edges.get(item.connection) : undefined;
    const authorization = item.authorization;
    const id = item.connection ?? `permission:${target.ref}:${authorization.kind}:${authorization.operation}:${JSON.stringify(authorization.grants)}`;
    const append = (side: "owned" | "incoming", selected: ConnectionAuthorization) => {
      const peer = side === "incoming" ? selected.grants.find(grant => grant.principalEntity && grant.principalEntity !== target.ref)?.principalEntity : undefined;
      const other = peer ?? (edge ? edge.from === target.ref ? edge.to : edge.from : undefined);
      const destination = other ? accessDestination(other, model, index) : {
        title: side === "owned" ? "IAM policy" : selected.grants[0]?.principal ?? "Event source",
        icon: "construct" as const,
        ...(side === "owned" ? { subtitle: selected.grants.map(grant => grant.scope).join(", ") } : {}),
      };
      result[side].push({ id, ...(item.connection ? { connection: item.connection } : {}), ...(edge ? { edge } : {}),
        authorization: selected, destination, operation: accessOperation(selected, edge, source),
        ...(side === "owned" && edge ? { remove: removalForConnection(target, edge, model, source) } : {}),
      });
    };
    if (authorization.kind === "iam") {
      const owned = authorization.grants.filter(grant => grant.principalEntity === target.ref);
      const incoming = authorization.grants.filter(grant => grant.principalEntity !== target.ref);
      if (owned.length) append("owned", { ...authorization, grants: owned });
      if (incoming.length) append("incoming", { ...authorization, grants: incoming });
    } else {
      append(edge && edge.from !== target.ref ? "incoming" : "owned", authorization);
    }
  }
  return result;
}
